import type Database from 'better-sqlite3'
import type { ArtifactIndex, CollatorFeedback, CollatorIssue, ContributionInventory, ExecutionScope } from '../../shared/contracts.generated'
import { ContractError } from '../../shared/validation'
import { isDeepStrictEqual } from 'node:util'
import type { RunnerArtifactState } from './artifact-state'
import type { Collator } from './collator'
import type { RunnerCompositionState } from './composition-state'
import type { RunnerWorkState } from './work-state'
import { requestDelivery } from './delivery-state'

type Goal = { request_id: string; intent_revision: number }
type FeedbackOwner = Extract<ExecutionScope, { purpose: 'composition' }>
type Recipient = CollatorFeedback['reports'][number]['recipient']
type Recorder = (task: string, kind: string, payload: unknown) => string
type Evidence = ReturnType<Collator['feedback']>
type Row = { id: string; payload_json: string }

export interface RepairRequest extends Goal {
  feedback_id: string
  problem_key: string
  batch_id: string
  run_id: string
  issue: CollatorIssue
  recipient: Recipient
  source_work_id?: string
  disposition: 'eligible' | 'obsolete' | 'duplicate'
}

export interface ArtifactRepair extends Goal {
  request_record_id: string
  problem_key: string
  repair_run_id: string
  repair_work_id: string
  previous: ArtifactIndex
  issue: Exclude<CollatorIssue, { kind: 'missing_requirement' }>
}
export type PendingRepair = RepairRequest & { request_record_id: string }

function problemKey(goal: Goal, issue: CollatorIssue): string {
  const subject = issue.kind === 'missing_requirement' ? issue.requirement.requirement_id : issue.artifact.artifact_id
  const constraint = issue.kind === 'artifact_size_limit' ? issue.max_bytes : issue.kind === 'artifact_section_mismatch' ? issue.expected_section_id : null
  return JSON.stringify([goal.request_id, goal.intent_revision, issue.kind, subject, constraint])
}

export class RunnerRepairState {
  constructor(private readonly db: Database.Database, private readonly work: RunnerWorkState, private readonly artifacts: RunnerArtifactState, private readonly composition: RunnerCompositionState) {}

  install(raw: Evidence, owner: FeedbackOwner, record: Recorder): string {
    const { result, issues } = raw, task = owner.task_id
    if (owner.role !== 'collator' || result.task_id !== task || result.run_id !== owner.run_id || result.batch_id !== owner.batch_id || result.composition_version !== owner.composition_version) throw new ContractError('RUNNER_OWNERSHIP_INVALID', 'Feedback must retain its exact Collator source')
    return this.db.transaction(() => {
      const previous = this.db.prepare("SELECT id,payload_json FROM records WHERE task_id=? AND kind='runner.composition.feedback' AND json_extract(payload_json,'$.owner.attempt_id')=?").get(task, owner.attempt_id) as Row | undefined
      if (previous) {
        if (!isDeepStrictEqual(JSON.parse(previous.payload_json), { owner, run_id: owner.run_id, ...raw })) throw new ContractError('INVALID_COLLATOR_FEEDBACK', 'An installed feedback receipt retains its original reports')
        return previous.id
      }
      const batch = this.composition.batch(task, owner.batch_id)
      if (!batch || batch.run_id !== owner.run_id || batch.composition_version !== owner.composition_version || batch.trigger_request_id !== owner.trigger_request_id) throw new ContractError('RUNNER_OWNERSHIP_INVALID', 'Feedback requires its original frozen batch')
      const source = this.work.qualify(owner.attempt_id)
      if (source.run.run_id !== owner.run_id || source.work.work_id !== owner.work_id || source.attempt.state !== 'succeeded' || source.attempt.profile_id !== 'collator-indexed-v1') throw new ContractError('RUNNER_OWNERSHIP_INVALID', 'Feedback requires the current Collator result')
      const feedback_id = record(task, 'runner.composition.feedback', { owner, run_id: owner.run_id, ...raw })
      for (const report of result.reports) {
        const issue = issues.find(item => item.evidence_id === report.evidence_id)
        if (!issue) throw new ContractError('INVALID_COLLATOR_FEEDBACK', 'Feedback evidence does not belong to its report')
        const index = issue.kind === 'missing_requirement' ? null : this.artifacts.artifact(task, issue.artifact.artifact_id, issue.artifact.artifact_revision)
        const goal = issue.kind === 'missing_requirement' ? issue.requirement : index
        if (!goal || !batch.targets.some(target => target.request_id === goal.request_id && target.intent_revision === goal.intent_revision)
          || report.recipient.kind === 'worker' && index?.work_id !== report.recipient.work_id) throw new ContractError('INVALID_COLLATOR_FEEDBACK', 'Feedback must name its original request and source')
        const problem_key = problemKey(goal, issue)
        const request: RepairRequest = { feedback_id, problem_key, batch_id: batch.batch_id, run_id: batch.run_id,
          request_id: goal.request_id, intent_revision: goal.intent_revision, issue, recipient: report.recipient,
          ...(index ? { source_work_id: index.work_id } : {}), disposition: 'eligible' }
        if (!this.current(task, request)) request.disposition = 'obsolete'
        else if (this.db.prepare(`SELECT 1 FROM records WHERE task_id=? AND kind='runner.repair.requested'
          AND json_extract(payload_json,'$.problem_key')=? AND json_extract(payload_json,'$.disposition')='eligible'
          AND json_extract(payload_json,'$.issue.artifact.artifact_revision') IS ? LIMIT 1`).get(task, problem_key, index?.artifact_revision ?? null)) request.disposition = 'duplicate'
        record(task, 'runner.repair.requested', request)
      }
      return feedback_id
    }).immediate()
  }

  current(task: string, request: RepairRequest): boolean {
    const { request_id, intent_revision, issue } = request
    const goal = this.work.goal(request_id)
    if (goal.task_id !== task || goal.intent_revision !== intent_revision || goal.state !== 'active') return false
    if (!this.db.prepare("SELECT 1 FROM requests WHERE task_id=? AND id=? AND state NOT IN ('cancelled','rejected')").get(task, request_id)) return false
    if (requestDelivery(this.db, task, request_id, intent_revision)?.state !== 'open') return false
    if (issue.kind === 'missing_requirement') {
      return !!this.composition.scope(task)?.unresolved.some(item => item.request_id === request_id && item.intent_revision === intent_revision && item.requirement_id === issue.requirement.requirement_id)
    }
    try { return this.composition.checkArtifact(task, issue.artifact.artifact_id, issue.artifact.artifact_revision).work_id === request.source_work_id }
    catch (error) {
      if (error instanceof ContractError && ['RUNNER_DEPENDENCY_INVALID', 'RUNNER_OWNERSHIP_INVALID'].includes(error.code)) return false
      throw error
    }
  }

  pending(task: string): PendingRepair[] {
    const rows = this.db.prepare(`SELECT r.id,r.payload_json FROM records r WHERE r.task_id=? AND r.kind='runner.repair.requested'
      AND json_extract(r.payload_json,'$.disposition')='eligible'
      AND NOT EXISTS (SELECT 1 FROM records s WHERE s.task_id=r.task_id AND s.kind IN ('runner.repair.started','runner.repair.routed','runner.repair.blocked') AND json_extract(s.payload_json,'$.request_record_id')=r.id)
      ORDER BY r.sequence`).all(task) as Row[]
    return rows.map(row => ({ ...JSON.parse(row.payload_json) as RepairRequest, request_record_id: row.id }))
  }

  request(task: string, id: string): PendingRepair {
    const row = this.db.prepare("SELECT payload_json FROM records WHERE task_id=? AND id=? AND kind='runner.repair.requested' AND json_extract(payload_json,'$.disposition')='eligible'").get(task, id) as Pick<Row, 'payload_json'> | undefined
    if (!row) throw new ContractError('REPAIR_OBSOLETE', 'The original eligible feedback is unavailable')
    return { ...JSON.parse(row.payload_json) as RepairRequest, request_record_id: id }
  }
}

export function repairRoutingWork(db: Database.Database, task: string, work: string): boolean {
  return !!db.prepare(`SELECT 1 FROM records WHERE task_id=? AND kind='runner.repair.routed' AND json_extract(payload_json,'$.work_id')=?`).get(task, work)
}

export function installedRepairDispatch(db: Database.Database, task: string, attempt: string): boolean {
  return !!db.prepare(`SELECT 1 FROM records WHERE task_id=? AND kind='runner.repair.plan' AND json_extract(payload_json,'$.owner.attempt_id')=?`).get(task, attempt)
}

function repairedRequirements(db: Database.Database, task: string, outputs: readonly { work_id: string; requirement_ids: readonly string[] }[]): Set<string> {
  const resolved = new Set<string>()
  for (const output of outputs) {
    const row = db.prepare(`SELECT json_extract(payload_json,'$.requirement_id') AS requirement_id FROM records r WHERE task_id=? AND kind='runner.repair.plan'
      AND EXISTS (SELECT 1 FROM json_each(r.payload_json,'$.work_ids') w WHERE w.value=?)`).get(task, output.work_id) as { requirement_id: string | null } | undefined
    if (row?.requirement_id && output.requirement_ids.includes(row.requirement_id)) resolved.add(row.requirement_id)
  }
  return resolved
}

export function unresolvedDeliveryRequirements(db: Database.Database, inventory: ContributionInventory): ContributionInventory['unresolved'] {
  if (!inventory.unresolved.length) return []
  const resolved = repairedRequirements(db, inventory.task_id, inventory.required_works)
  return inventory.unresolved.filter(item => !resolved.has(item.requirement_id))
}

export function artifactRepair(db: Database.Database, task: string, work: string): ArtifactRepair | null {
  const row = db.prepare(`SELECT payload_json FROM records WHERE task_id=? AND kind IN ('runner.repair.started','runner.repair.rebound')
    AND json_extract(payload_json,'$.repair_work_id')=? AND json_type(payload_json,'$.previous')='object' ORDER BY sequence DESC LIMIT 1`).get(task, work) as Pick<Row, 'payload_json'> | undefined
  return row ? JSON.parse(row.payload_json) as ArtifactRepair : null
}

export function repairRequestId(db: Database.Database, task: string, work: string): string | undefined {
  return (db.prepare(`SELECT json_extract(payload_json,'$.request_record_id') AS id FROM records WHERE task_id=? AND (
    kind='runner.repair.routed' AND json_extract(payload_json,'$.work_id')=? OR kind='runner.repair.plan'
      AND EXISTS (SELECT 1 FROM json_each(payload_json,'$.work_ids') WHERE value=?)) ORDER BY sequence DESC LIMIT 1`).get(task, work, work) as { id: string } | undefined)?.id
}

export function repairSuccessor(db: Database.Database, original: ArtifactIndex, next: ArtifactIndex): boolean {
  if (original.artifact_id !== next.artifact_id || original.task_id !== next.task_id || original.request_id !== next.request_id || original.intent_revision !== next.intent_revision) return false
  let revision = next.artifact_revision
  while (revision > original.artifact_revision) {
    const step = db.prepare(`SELECT json_extract(payload_json,'$.previous.artifact_revision') AS previous FROM records
      WHERE task_id=? AND kind='runner.repair.applied' AND json_extract(payload_json,'$.previous.artifact_id')=?
      AND json_extract(payload_json,'$.artifact_revision')=?`).get(original.task_id, original.artifact_id, revision) as { previous: number } | undefined
    if (!step || !Number.isSafeInteger(step.previous) || step.previous !== revision - 1) return false
    revision = step.previous
  }
  return next.artifact_revision > original.artifact_revision && revision === original.artifact_revision
}

export function fragmentHasFeedback(db: Database.Database, task: string, artifact: string, revision: number): boolean {
  return !!db.prepare(`SELECT 1 FROM records WHERE task_id=? AND kind='runner.repair.requested'
    AND json_extract(payload_json,'$.disposition')='eligible' AND json_extract(payload_json,'$.issue.artifact.artifact_id')=?
    AND json_extract(payload_json,'$.issue.artifact.artifact_revision')=? LIMIT 1`).get(task, artifact, revision)
}

export function requirementHasFeedback(db: Database.Database, requirement: Extract<CollatorIssue, { kind: 'missing_requirement' }>['requirement']): boolean {
  return !!db.prepare(`SELECT 1 FROM records WHERE task_id=? AND kind='runner.repair.requested'
    AND json_extract(payload_json,'$.problem_key')=? AND json_extract(payload_json,'$.disposition')='eligible' LIMIT 1`)
    .get(requirement.task_id, problemKey(requirement, { kind: 'missing_requirement', evidence_id: '', requirement }))
}
