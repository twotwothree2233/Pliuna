import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { ArtifactIndex, CompositionBatch, ExecutionScope, ContentPlan, PublicationEntry, WorkOutputDeclaration } from '../../shared/contracts.generated'
import type { Run, RunnerFinalAnswer, RunnerGoalProjection, RunnerProjection, RunnerScopeProjection } from '../../shared/types'
import { validateRunnerContract } from '../../shared/runner-validation'
import { ContractError } from '../../shared/validation'
import { RunnerArtifactState } from './artifact-state'
import { RunnerCompositionState } from './composition-state'
import { RunnerHostComposition } from './host-composition'
import { RUNNER_LIMITS, assertRunnerId } from './limits'
import type { TaskRunnerStatusQuery } from './task-runner'
import { RunnerWorkState } from './work-state'
import { runnerFailureReason } from './failure-reason'
import { containsProducerResult } from './production-result'
import { requestDelivery } from './delivery-state'
import { unresolvedDeliveryRequirements } from './repair-state'

type Payload = { payload_json: string }
type GoalRow = Payload & { position: number; request_id: string; intent_revision: number }
type RecordMetadata = { id: string; kind: string; created_at: string }
type Cursor = { task: string; request: string | null; epoch: string; after: number; through: number }
const cursors = new WeakMap<Database.Database, Map<string, Cursor>>()
const answerContents = new WeakMap<Database.Database, Map<string, boolean>>()
const failedRuns = new Set(['failed', 'cancelled', 'interrupted'])
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value))
const code = (value: unknown, fallback: string): string => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : fallback
function fail(cursor = false): never { throw new ContractError(cursor ? 'INVALID_CURSOR' : 'RUNNER_STATUS_INVALID', cursor ? 'Runner status cursor is expired or belongs to another query' : 'Runner status requires bounded consistent metadata') }
function title(value: string): string {
  let result = '', size = 0
  for (const character of value) { const next = Buffer.byteLength(character); if (size + next > 256) break; result += character; size += next }
  return result
}
function sameGoal(goal: ContentPlan, value: { task_id: string; request_id: string; intent_revision: number }): boolean {
  return goal.task_id === value.task_id && goal.request_id === value.request_id && goal.intent_revision === value.intent_revision
}
function sameReference(left: WorkOutputDeclaration['result_ref'], right: WorkOutputDeclaration['result_ref']): boolean {
  return left.kind === right.kind && left.task_id === right.task_id && left.id === right.id
}

// Status cursors retain only bounded metadata for this live database handle.
// Reading status never installs consumption, publication or execution authority.
export class RunnerHostStatus {
  private readonly work: RunnerWorkState
  private readonly artifacts: RunnerArtifactState
  private readonly composition: RunnerCompositionState
  private readonly host: RunnerHostComposition
  constructor(private readonly db: Database.Database, private readonly epoch: string) {
    this.work = new RunnerWorkState(db, epoch)
    this.artifacts = new RunnerArtifactState(db, this.work)
    this.composition = new RunnerCompositionState(db, this.work, this.artifacts)
    this.host = new RunnerHostComposition(db, this.work, this.artifacts, this.composition)
  }

  page(query: TaskRunnerStatusQuery): RunnerProjection {
    assertRunnerId(query.task_id, 'task_id')
    if (query.request_id !== undefined) assertRunnerId(query.request_id, 'request_id')
    const limit = query.limit ?? 16
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > RUNNER_LIMITS.index.page_items) fail()
    if (!this.db.prepare('SELECT 1 FROM tasks WHERE id=?').get(query.task_id)) throw new ContractError('RUNNER_NOT_FOUND', 'Runner status Task is unavailable')
    return this.db.transaction(() => {
      const saved = query.cursor === undefined ? null : this.cursor(query)
      const through = saved?.through ?? (this.db.prepare('SELECT COALESCE(MAX(position),0) value FROM runner_current_content_plans WHERE task_id=?').get(query.task_id) as { value: number }).value
      const rows = this.db.prepare('SELECT h.position position,h.request_id,h.intent_revision,h.payload_json FROM runner_current_content_plans h WHERE h.task_id=? AND (? IS NULL OR h.request_id=?) AND h.position>? AND h.position<=? ORDER BY h.position LIMIT ?').all(query.task_id, query.request_id ?? null, query.request_id ?? null, saved?.after ?? 0, through, limit + 1) as GoalRow[]
      const scope = this.scope(query.task_id), goals: RunnerGoalProjection[] = []
      for (const row of rows.slice(0, limit)) {
        const goal = validateRunnerContract('runner_content_plan', JSON.parse(row.payload_json))
        if (goal.task_id !== query.task_id || goal.request_id !== row.request_id || goal.intent_revision !== row.intent_revision) fail()
        const item = this.goal(goal)
        while (bytes(item) > RUNNER_LIMITS.index.item_bytes && item.waits.length) item.waits.pop()
        if (bytes(item) > RUNNER_LIMITS.index.item_bytes) fail()
        if (bytes({ goals: [...goals, item], next_cursor: 'x'.repeat(36), scope }) > RUNNER_LIMITS.index.page_bytes) break
        goals.push(item)
      }
      const next_cursor = rows.length > goals.length ? this.remember({ task: query.task_id, request: query.request_id ?? null, epoch: this.epoch, after: rows[goals.length - 1]!.position, through }) : null
      return { goals, next_cursor, scope }
    })()
  }

  private cursor(query: TaskRunnerStatusQuery): Cursor {
    if (typeof query.cursor !== 'string' || query.cursor.length > RUNNER_LIMITS.index.item_bytes) return fail(true)
    const saved = cursors.get(this.db)?.get(query.cursor)
    if (!saved || saved.task !== query.task_id || saved.request !== (query.request_id ?? null) || saved.epoch !== this.epoch) return fail(true)
    return saved
  }
  private remember(value: Cursor): string {
    let saved = cursors.get(this.db)
    if (!saved) { saved = new Map(); cursors.set(this.db, saved) }
    while (saved.size >= 256) saved.delete(saved.keys().next().value!)
    const token = randomUUID(); saved.set(token, value); return token
  }

  private run(goal: ContentPlan): Run | null {
    const row = this.db.prepare("SELECT r.run_id,c.primary_reason,c.wait_reason FROM runner_runs r JOIN runs c ON c.id=r.run_id AND c.task_id=r.task_id WHERE r.task_id=? AND r.request_id=? AND r.intent_revision=? AND r.purpose='production' ORDER BY r.rowid DESC LIMIT 1").get(goal.task_id, goal.request_id, goal.intent_revision) as { run_id: string; primary_reason: string | null; wait_reason: string | null } | undefined
    if (!row) return null
    const source = this.work.run(row.run_id)
    if (source.purpose !== 'production' || !sameGoal(goal, source)) fail()
    const reason = source.state === 'failed' ? runnerFailureReason(this.db, goal.task_id, source.run_id, row.primary_reason) : row.primary_reason
    return { id: source.run_id, state: source.state, primary_reason: reason === null ? null : code(reason, 'execution_ended'), ...(row.wait_reason === null ? {} : { wait_reason: code(row.wait_reason, 'work_waiting') }), source }
  }

  private request(goal: ContentPlan): RecordMetadata | null {
    const row = this.db.prepare('SELECT r.id,r.kind,r.created_at FROM runner_inputs i JOIN records r ON r.id=i.record_id AND r.task_id=i.task_id WHERE i.task_id=? AND i.input_event_id=?').get(goal.task_id, goal.input_event_id) as RecordMetadata | undefined
    if (!row) return null
    assertRunnerId(row.id, 'record_id')
    if (row.created_at.length > 64 || code(row.kind, '') !== row.kind) fail()
    return row
  }
  private goalTitle(goal: ContentPlan): string {
    const row = this.db.prepare("SELECT substr(json_extract(r.payload_json,'$.text'),1,256) text FROM runner_content_plans g JOIN runner_inputs i ON i.input_event_id=g.input_event_id AND i.task_id=g.task_id JOIN records r ON r.id=i.record_id AND r.task_id=g.task_id WHERE g.task_id=? AND g.request_id=? ORDER BY g.intent_revision LIMIT 1").get(goal.task_id, goal.request_id) as { text: unknown } | undefined
    return title(typeof row?.text === 'string' ? row.text : '')
  }

  private answer(goal: ContentPlan): RunnerFinalAnswer | null {
    if (goal.state !== 'active') return null
    const rows = this.db.prepare("SELECT r.id,r.created_at,json_extract(r.payload_json,'$.owner') owner_json,json_extract(r.payload_json,'$.result_ref') result_ref_json FROM records r JOIN runner_work w ON w.work_id=json_extract(r.payload_json,'$.owner.work_id') AND w.task_id=r.task_id JOIN runner_attempts a ON a.attempt_id=json_extract(r.payload_json,'$.owner.attempt_id') AND a.work_id=w.work_id AND a.task_id=w.task_id AND a.run_id=w.run_id JOIN runner_runs n ON n.run_id=w.run_id AND n.task_id=w.task_id WHERE r.task_id=? AND r.kind='runner.answer' AND json_extract(r.payload_json,'$.purpose')='final_answer' AND json_extract(r.payload_json,'$.request_id')=? AND json_extract(r.payload_json,'$.intent_revision')=? AND json_extract(r.payload_json,'$.input_event_id')=? AND json_extract(r.payload_json,'$.run_id')=n.run_id AND json_extract(r.payload_json,'$.owner.run_id')=n.run_id AND json_extract(r.payload_json,'$.owner.task_id')=r.task_id AND json_extract(r.payload_json,'$.owner.purpose')='production' AND json_extract(r.payload_json,'$.owner.request_id')=n.request_id AND json_extract(r.payload_json,'$.owner.intent_revision')=n.intent_revision AND n.purpose='production' AND n.request_id=? AND n.intent_revision=? AND w.state='succeeded' AND a.state='succeeded' AND json_extract(w.payload_json,'$.current_attempt_id')=a.attempt_id ORDER BY r.sequence DESC LIMIT 16").all(goal.task_id, goal.request_id, goal.intent_revision, goal.input_event_id, goal.request_id, goal.intent_revision) as { id: string; created_at: string; owner_json: string; result_ref_json: string | null }[]
    for (const row of rows) {
      try {
        const owner: ExecutionScope = validateRunnerContract('runner_execution_scope', JSON.parse(row.owner_json))
        const work = this.work.work(owner.work_id), attempt = this.work.attempt(owner.attempt_id), run = this.work.run(owner.run_id)
        if (owner.purpose !== 'production' || work.purpose !== 'production' || attempt.purpose !== 'production' || run.purpose !== 'production' || !sameGoal(goal, owner) || !sameGoal(goal, work) || !sameGoal(goal, attempt) || !sameGoal(goal, run) || owner.role !== work.role || owner.run_id !== work.run_id || attempt.run_id !== work.run_id || attempt.runtime_epoch !== run.runtime_epoch || attempt.work_id !== work.work_id || work.current_attempt_id !== attempt.attempt_id || work.state !== 'succeeded' || attempt.state !== 'succeeded' || !attempt.result_ref || work.result_revision === undefined || !row.result_ref_json) continue
        const output = this.composition.output(goal.task_id, work.work_id, work.plan_revision, work.result_revision)
        const reference = JSON.parse(row.result_ref_json) as WorkOutputDeclaration['result_ref']
        if (!output || output.run_id !== work.run_id || output.attempt_id !== attempt.attempt_id || !sameGoal(goal, output) || !sameReference(output.result_ref, attempt.result_ref) || !sameReference(reference, output.result_ref)) continue
        assertRunnerId(row.id, 'record_id'); if (row.created_at.length > 64) fail()
        if (!this.answerContent(goal.task_id, row.id)) continue
        return { id: row.id, kind: 'runner.answer', created_at: row.created_at, purpose: 'final_answer', request_id: goal.request_id, intent_revision: goal.intent_revision, input_event_id: goal.input_event_id, run_id: owner.run_id }
      } catch (error) { if (!(error instanceof ContractError || error instanceof SyntaxError)) throw error }
    }
    return null
  }

  private answerContent(task: string, record: string): boolean {
    let cache = answerContents.get(this.db)
    if (!cache) { cache = new Map(); answerContents.set(this.db, cache) }
    const saved = cache.get(record)
    if (saved !== undefined) return saved
    // Records are immutable. Cache content classification, never current ownership.
    const row = this.db.prepare("SELECT json_extract(payload_json,'$.text') text FROM records WHERE task_id=? AND id=?").get(task, record) as { text: unknown } | undefined
    const safe = typeof row?.text === 'string' && !containsProducerResult(row.text)
    while (cache.size >= 256) cache.delete(cache.keys().next().value!)
    cache.set(record, safe)
    return safe
  }

  private compositionWaits(goal: ContentPlan, accepted: ArtifactIndex[], published: PublicationEntry[], limit: number): RunnerGoalProjection['waits'] {
    if (goal.state !== 'active' || !limit) return []
    const pending = accepted.filter(index => !published.some(entry => sameGoal(goal, entry) && entry.artifact_id === index.artifact_id && entry.artifact_revision === index.artifact_revision)).map(index => ({ artifact_id: index.artifact_id, artifact_revision: index.artifact_revision }))
    if (!pending.length) return []
    // Only the latest batch still responsible for a current unpublished fragment
    // can obstruct this goal. A batch's trigger alone does not give it ownership.
    const rows = this.db.prepare(`SELECT b.payload_json FROM runner_batches b WHERE b.task_id=?
      AND EXISTS (SELECT 1 FROM json_each(b.payload_json,'$.targets') target WHERE json_extract(target.value,'$.request_id')=? AND json_extract(target.value,'$.intent_revision')=?)
      AND EXISTS (SELECT 1 FROM json_each(b.payload_json,'$.indexes') item JOIN json_each(?) pending
        ON json_extract(item.value,'$.artifact_id')=json_extract(pending.value,'$.artifact_id') AND json_extract(item.value,'$.artifact_revision')=json_extract(pending.value,'$.artifact_revision')
        WHERE NOT EXISTS (SELECT 1 FROM runner_batches newer,json_each(newer.payload_json,'$.indexes') replacement
          WHERE newer.task_id=b.task_id AND newer.rowid>b.rowid AND json_extract(replacement.value,'$.artifact_id')=json_extract(item.value,'$.artifact_id') AND json_extract(replacement.value,'$.artifact_revision')=json_extract(item.value,'$.artifact_revision')))
      ORDER BY b.rowid DESC LIMIT ?`).all(goal.task_id, goal.request_id, goal.intent_revision, JSON.stringify(pending), limit) as Payload[]
    const waits: RunnerGoalProjection['waits'] = []
    for (const row of rows) {
      const batch: CompositionBatch = validateRunnerContract('runner_composition_batch', JSON.parse(row.payload_json))
      const run = this.db.prepare('SELECT state,wait_reason FROM runs WHERE id=? AND task_id=?').get(batch.run_id, goal.task_id) as { state: string; wait_reason: string | null } | undefined
      const identity = { run_id: batch.run_id, batch_id: batch.batch_id, ...(batch.operation_id ? { operation_id: batch.operation_id } : {}) }
      const approval = this.db.prepare("SELECT p.id FROM approvals p JOIN actions a ON a.id=p.action_id WHERE a.task_id=? AND a.id=? AND a.run_id=? AND a.state!='ended' AND a.commit_valid=1 AND p.decision='pending' AND p.validity='valid' AND p.expires_at>? ORDER BY p.rowid DESC LIMIT 1").get(goal.task_id, batch.action_id ?? '', batch.run_id, new Date().toISOString()) as { id: string } | undefined
      if (approval) waits.push({ reason: 'approval', ...identity, approval_id: approval.id })
      else {
        const result = batch.operation_id ? this.host.operation(goal.task_id, batch.operation_id)?.result : null
        if (result && result.state !== 'published') waits.push({ reason: result.state === 'unknown' ? 'unknown' : code(result.code, 'composition_blocked'), ...identity })
        else if (['failed', 'unknown', 'cancelled'].includes(batch.state)) {
          const blocked = this.db.prepare("SELECT json_extract(payload_json,'$.code') code FROM records WHERE task_id=? AND kind='runner.composition.blocked' AND json_extract(payload_json,'$.batch_id')=? AND json_extract(payload_json,'$.run_id')=? ORDER BY sequence DESC LIMIT 1").get(goal.task_id, batch.batch_id, batch.run_id) as { code: unknown } | undefined
          waits.push({ reason: batch.state === 'unknown' ? 'unknown' : code(blocked?.code, 'composition_blocked'), ...identity })
        } else if (run && ['running', 'waiting', 'closing'].includes(run.state)) waits.push({ reason: run.state === 'closing' ? 'ending_cleanup' : code(run.wait_reason, 'composition_preparing'), ...identity })
      }
      if (waits.length >= limit) break
    }
    return waits
  }

  private usageWaits(run: Run): RunnerGoalProjection['waits'] {
    if (run.state !== 'closing' || !run.source) return []
    const task = run.source.task_id
    // Only describe stopped execution when persisted operations have ended.
    // Unknown usage still retains its reservation and production admission.
    if (this.db.prepare("SELECT 1 FROM runner_attempts WHERE run_id=? AND (state NOT IN ('succeeded','failed','cancelled','revoked') OR json_extract(payload_json,'$.dispatch_state')='unknown') LIMIT 1").get(run.id) ||
      this.db.prepare("SELECT 1 FROM calls WHERE run_id=? AND (state!='ended' OR execution='unknown') LIMIT 1").get(run.id) ||
      this.db.prepare("SELECT 1 FROM actions WHERE task_id=? AND (run_id=? OR json_extract(source_json,'$.owner.run_id')=?) AND (state!='ended' OR result='unknown') LIMIT 1").get(task, run.id, run.id) ||
      this.db.prepare("SELECT 1 FROM cleanup_jobs WHERE (task_id=? OR task_id IS NULL) AND necessary=1 AND state!='done' LIMIT 1").get(task)) return []
    const unresolved = this.db.prepare(`SELECT 1 FROM runner_budget_reservations b JOIN runner_attempts a ON a.attempt_id=b.attempt_id
      WHERE a.run_id=? AND b.state IN ('reserved','unknown') AND (
        b.state!='unknown' OR json_extract(b.reserved_json,'$.model_requests')<1 OR json_extract(b.reserved_json,'$.tool_requests')!=0
        OR NOT EXISTS (SELECT 1 FROM records r WHERE r.task_id=b.task_id AND r.kind='model.request.accounting'
          AND json_extract(r.payload_json,'$.request_id')=b.operation_id AND json_extract(r.payload_json,'$.run_id')=a.run_id
          AND json_extract(r.payload_json,'$.owner.attempt_id')=a.attempt_id AND json_extract(r.payload_json,'$.phase') IN ('completed','failed'))
      ) LIMIT 1`).get(run.id)
    if (unresolved) return []
    const rows = this.db.prepare("SELECT b.operation_id,a.work_id FROM runner_budget_reservations b JOIN runner_attempts a ON a.attempt_id=b.attempt_id WHERE a.run_id=? AND b.state='unknown' ORDER BY b.rowid LIMIT 8").all(run.id) as { operation_id: string; work_id: string }[]
    return rows.map(row => ({ reason: 'usage_unknown', run_id: run.id, work_id: row.work_id, operation_id: row.operation_id }))
  }

  private waits(goal: ContentPlan, run: Run | null, accepted: ArtifactIndex[], published: PublicationEntry[]): RunnerGoalProjection['waits'] {
    const waits: RunnerGoalProjection['waits'] = []
    const approvals = this.db.prepare("SELECT p.id,a.run_id,w.work_id FROM approvals p JOIN actions a ON a.id=p.action_id JOIN runner_runs r ON r.run_id=a.run_id AND r.task_id=a.task_id LEFT JOIN runner_work w ON w.work_id=json_extract(a.source_json,'$.owner.work_id') AND w.task_id=a.task_id AND w.run_id=a.run_id WHERE r.task_id=? AND r.purpose='production' AND r.request_id=? AND r.intent_revision=? AND p.decision='pending' AND p.validity='valid' AND a.state!='ended' AND a.commit_valid=1 AND p.expires_at>? ORDER BY p.rowid LIMIT 8").all(goal.task_id, goal.request_id, goal.intent_revision, new Date().toISOString()) as { id: string; run_id: string; work_id: string | null }[]
    for (const approval of approvals) waits.push({ reason: 'approval', run_id: approval.run_id, ...(approval.work_id ? { work_id: approval.work_id } : {}), approval_id: approval.id })
    waits.push(...this.compositionWaits(goal, accepted, published, 8 - waits.length))
    const usage = run ? this.usageWaits(run) : []
    if (usage.length) return [...usage, ...waits].slice(0, 8)
    if (run && ['queued', 'running', 'waiting', 'closing'].includes(run.state) && waits.length < 8) {
      const rows = this.db.prepare("SELECT w.work_id,w.state,a.state attempt_state FROM runner_work w LEFT JOIN runner_attempts a ON a.attempt_id=json_extract(w.payload_json,'$.current_attempt_id') WHERE w.task_id=? AND w.run_id=? AND (w.state='waiting' OR a.state='unknown' OR w.state IN ('planned','queued') AND json_array_length(json_extract(w.payload_json,'$.dependencies'))>1) ORDER BY w.rowid LIMIT ?").all(goal.task_id, run.id, 8 - waits.length) as { work_id: string; state: string; attempt_state: string | null }[]
      for (const work of rows) {
        const reason = work.attempt_state === 'unknown' ? 'unknown' : work.state === 'waiting' ? 'work_waiting' : 'dependency'
        if (!waits.some(wait => wait.work_id === work.work_id && wait.reason === reason)) waits.push({ reason, run_id: run.id, work_id: work.work_id })
      }
      if (waits.length < 8 && (run.wait_reason || run.state === 'waiting' || run.state === 'closing')) waits.push({ reason: run.state === 'closing' ? 'ending_cleanup' : run.wait_reason ?? 'work_waiting', run_id: run.id })
    }
    return waits
  }

  private published(task: string, request?: string): PublicationEntry[] {
    return this.host.publications.mappings(task).filter(entry => (!request || entry.request_id === request) && !!this.db.prepare("SELECT 1 FROM views v JOIN surfaces s ON s.id=v.surface_id WHERE s.task_id=? AND v.id=? AND v.revision=? AND v.bundle_resource_id=? AND EXISTS(SELECT 1 FROM json_each(s.layout_json,'$.slots') sl,json_each(sl.value,'$.groups') g,json_each(g.value,'$.views') item WHERE item.value=v.id)").get(task, entry.view_id, entry.view_revision, entry.published_bundle_resource_id))
  }
  private accepted(goal: ContentPlan): ArtifactIndex[] {
    const rows = this.db.prepare("SELECT a.payload_json FROM runner_artifacts a JOIN runner_artifact_owners o ON o.task_id=a.task_id AND o.artifact_id=a.artifact_id AND o.current_revision=a.artifact_revision WHERE a.task_id=? AND json_extract(a.payload_json,'$.request_id')=? AND json_extract(a.payload_json,'$.intent_revision')=?").all(goal.task_id, goal.request_id, goal.intent_revision) as Payload[]
    return rows.map(row => validateRunnerContract('runner_artifact_index', JSON.parse(row.payload_json))).filter(index => {
      try { this.composition.checkArtifact(goal.task_id, index.artifact_id, index.artifact_revision); return this.composition.publicationArtifact(index) }
      catch (error) { if (!(error instanceof ContractError)) throw error; return false }
    })
  }

  private goal(goal: ContentPlan): RunnerGoalProjection {
    const run = this.run(goal), reply = this.answer(goal), accepted = this.accepted(goal), published = this.published(goal.task_id, goal.request_id)
    const settlement = requestDelivery(this.db, goal.task_id, goal.request_id, goal.intent_revision)
    let inventory = this.composition.inventory(goal.task_id, goal.request_id, goal.intent_revision)
    try { if (inventory) inventory = this.composition.checkInventory(goal.task_id, goal.request_id, goal.intent_revision, inventory.inventory_revision) } catch (error) { if (!(error instanceof ContractError)) throw error; inventory = null }
    const covered = new Set(inventory?.requirement_ids ?? []), unresolved = new Set(inventory ? unresolvedDeliveryRequirements(this.db, inventory).map(item => item.requirement_id) : [])
    const missingAnswer = !reply && goal.requirements.some(requirement => requirement.required && requirement.kind === 'answer')
    for (const requirement of goal.requirements) if (requirement.required && (!covered.has(requirement.requirement_id) || requirement.kind === 'answer' && !reply)) unresolved.add(requirement.requirement_id)
    const fragments = inventory ? this.composition.currentArtifacts(inventory) : []
    const delivered = !!inventory && !unresolved.size && fragments.every(fragment => published.some(entry => sameGoal(goal, entry) && entry.artifact_id === fragment.artifact_id && entry.artifact_revision === fragment.artifact_revision)) && (!goal.requirements.some(requirement => requirement.required && requirement.kind === 'answer') || !!reply)
    const stale = published.some(entry => !sameGoal(goal, entry) || !accepted.some(index => index.artifact_id === entry.artifact_id && index.artifact_revision === entry.artifact_revision))
    const delivery = settlement?.state === 'complete' ? 'published' : settlement?.state === 'incomplete' ? 'incomplete'
      : settlement?.state === 'open' ? stale ? 'pending_update' : accepted.length ? 'accepted' : 'pending'
      : delivered ? 'published' : missingAnswer && inventory ? 'incomplete' : stale ? 'pending_update' : accepted.length ? 'accepted' : reply ? 'incomplete' : run && (failedRuns.has(run.state) || run.state === 'completed') || goal.state === 'withdrawn' ? 'incomplete' : 'pending'
    const artifact_count = new Set([...accepted, ...published.filter(entry => sameGoal(goal, entry))].map(entry => entry.artifact_id)).size
    return { request_id: goal.request_id, intent_revision: goal.intent_revision, input_event_id: goal.input_event_id, title: this.goalTitle(goal), state: goal.state, run, waits: this.waits(goal, run, accepted, published), delivery, artifact_count, unresolved_count: settlement?.state === 'incomplete' ? settlement.missing_requirement_ids.length : unresolved.size, request: this.request(goal), reply }
  }

  scope(task: string): RunnerScopeProjection | null {
    const scope = this.composition.scope(task)
    if (!scope) return null
    const complete = this.host.completeness(task), published = this.published(task)
    const requirementKey = (request: string, revision: number, requirement: string) => JSON.stringify([request, revision, requirement])
    const unresolved = new Set(complete.unresolved.map(item => requirementKey(item.request_id, item.intent_revision, item.requirement_id)))
    // Scope completeness covers every required goal, including goals off this page.
    for (const target of scope.targets) {
      if (!target.required) continue
      try {
        const goal = this.work.goal(target.request_id)
        if (goal.task_id !== task || goal.intent_revision !== target.intent_revision || goal.state !== 'active') continue
        const answers = goal.requirements.filter(requirement => requirement.required && requirement.kind === 'answer')
        if (answers.length && !this.answer(goal)) for (const requirement of answers) unresolved.add(requirementKey(goal.request_id, goal.intent_revision, requirement.requirement_id))
      } catch (error) { if (!(error instanceof ContractError)) throw error }
    }
    const pendingChapters = new Set(scope.targets.flatMap(target => this.composition.pendingChapterUpdates(task, target.request_id, target.intent_revision)))
    const pending = published.filter(entry => {
      const target = scope.targets.find(target => target.request_id === entry.request_id)
      if (!target) return false
      const goal = this.work.goal(entry.request_id)
      if (!sameGoal(goal, entry)) return true
      try { this.composition.checkArtifact(task, entry.artifact_id, entry.artifact_revision); return false }
      catch (error) { if (!(error instanceof ContractError)) throw error; return true }
    }).length
    const running = !!this.db.prepare("SELECT 1 FROM runner_runs r JOIN runs c ON c.id=r.run_id WHERE r.task_id=? AND c.state IN ('running','waiting') LIMIT 1").get(task)
    return { composition_version: scope.composition_version, state: complete.state === 'complete' && !unresolved.size ? 'complete' : published.length || !running ? 'partial' : 'working', required_content_count: scope.targets.filter(target => target.required).length, unresolved_count: unresolved.size, pending_update_count: pending + pendingChapters.size, published_count: published.length }
  }
}
