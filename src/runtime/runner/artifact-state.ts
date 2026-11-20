import type Database from 'better-sqlite3'
import type { ArtifactCandidate, ArtifactIndex, Outline, OutlineSection, WorkDependency } from '../../shared/contracts.generated'
import defaults from '../../shared/contracts/development-defaults.json'
import { isBundleMediaType } from '../../shared/branding'
import { validateArtifactCandidate, validateRunnerContract } from '../../shared/runner-validation'
import { ContractError } from '../../shared/validation'
import { assertRunnerId } from './limits'
import { registerRunnerResources } from './resource-references'
import type { RunnerWorkState } from './work-state'
import { ChapterArtifactState, type ChapterAssemblyInstall } from './chapter-artifact'
export type { ChapterArtifactAssembly, ChapterAssemblyInstall } from './chapter-artifact'

export interface ArtifactOwnerRef { work_id: string; plan_revision: number }
export interface ArtifactAssignment extends ArtifactOwnerRef {
  task_id: string
  artifact_id: string
  section_id: string
  base_artifact_revision: number
  previous_owner?: ArtifactOwnerRef | null
}
export interface ArtifactOwner extends ArtifactOwnerRef {
  task_id: string
  artifact_id: string
  section_id: string
  current_revision: number
}
export type CandidateReview = { state: 'accepted' } | { state: 'rejected'; code: string }
export type ArtifactDecision = { state: 'accepted'; index: ArtifactIndex } | { state: 'rejected'; code: string }
export interface CandidateRecord { candidate: ArtifactCandidate; result: ArtifactDecision }
type PayloadRow = { payload_json: string }
type CandidateRow = PayloadRow & { task_id: string; result_json: string }

function fail(code: string, message: string): never { throw new ContractError(code, message) }
function revision(value: unknown, minimum = 1): void {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) fail('INVALID_RUNNER_CONTRACT', 'Artifact revisions must be safe nonnegative integers')
}
function json(value: unknown): string {
  try {
    const result = JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === 'number' && !Number.isFinite(item) || !['object', 'string', 'boolean', 'number'].includes(typeof item)) throw Error()
      return item
    })
    if (result === undefined) throw Error()
    return result
  } catch { return fail('INVALID_RUNNER_CONTRACT', 'Artifact state must be finite JSON') }
}
function equivalent(left: unknown, right: unknown): boolean {
  const normalize = (value: any): any => Array.isArray(value) ? value.map(normalize) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])])) : value
  return json(normalize(left)) === json(normalize(right))
}
function keys(value: object, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail('INVALID_RUNNER_CONTRACT', 'Artifact state contains unknown fields')
}
function review(value: CandidateReview): CandidateReview {
  const result = JSON.parse(json(value)) as CandidateReview
  if (!result || typeof result !== 'object' || !['accepted', 'rejected'].includes(result.state)) fail('INVALID_RUNNER_CONTRACT', 'Invalid candidate review')
  keys(result, result.state === 'accepted' ? ['state'] : ['state', 'code'])
  if (result.state === 'rejected' && (typeof result.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(result.code))) fail('INVALID_RUNNER_CONTRACT', 'Candidate rejection requires a bounded reason code')
  return result
}

// This Module installs metadata only. An accepted review must come from the
// host's content/resource validation Adapter; it does not validate bundle bodies.
export class RunnerArtifactState {
  constructor(private readonly db: Database.Database, private readonly work: RunnerWorkState) {}

  private activeTask(taskId: string): void {
    if (!this.db.prepare("SELECT id FROM tasks WHERE id=? AND state='active'").get(taskId)) fail('RUNNER_OWNERSHIP_INVALID', 'Task is not active')
  }

  outline(taskId: string, outlineRevision?: number): Outline | null {
    assertRunnerId(taskId, 'task_id')
    if (outlineRevision !== undefined) revision(outlineRevision)
    const row = (outlineRevision === undefined
      ? this.db.prepare('SELECT payload_json FROM runner_outlines WHERE task_id=? ORDER BY outline_revision DESC LIMIT 1').get(taskId)
      : this.db.prepare('SELECT payload_json FROM runner_outlines WHERE task_id=? AND outline_revision=?').get(taskId, outlineRevision)) as PayloadRow | undefined
    return row ? validateRunnerContract('runner_outline', JSON.parse(row.payload_json)) : null
  }

  acceptOutline(raw: Outline, attemptId: string): Outline {
    const outline = validateRunnerContract('runner_outline', JSON.parse(json(raw)))
    return this.db.transaction(() => {
      const qualified = this.work.qualify(attemptId)
      if (qualified.task_id !== outline.task_id || qualified.work.purpose !== 'production' || qualified.work.role !== 'router' || !['running', 'waiting', 'succeeded'].includes(qualified.attempt.state)) fail('RUNNER_OWNERSHIP_INVALID', 'Outline proposals require a current dispatched Router')
      return this.installOutline(outline)
    }).immediate()
  }

  installOutline(raw: Outline): Outline {
    const outline = validateRunnerContract('runner_outline', JSON.parse(json(raw)))
    revision(outline.outline_revision); revision(outline.base_outline_revision, 0)
    return this.db.transaction(() => {
      const existing = this.outline(outline.task_id, outline.outline_revision)
      if (existing) {
        if (!equivalent(existing, outline)) fail('RUNNER_OUTLINE_CONFLICT', 'An installed outline revision cannot be overwritten')
        return existing
      }
      this.activeTask(outline.task_id)
      const current = this.outline(outline.task_id)
      if (outline.base_outline_revision !== (current?.outline_revision ?? 0) || outline.outline_revision !== outline.base_outline_revision + 1) fail('RUNNER_OUTLINE_CONFLICT', 'Outline must advance its exact current predecessor')
      for (const section of outline.sections) {
        revision(section.position_revision); revision(section.intent_revision)
        const goal = this.work.goal(section.request_id)
        if (goal.task_id !== outline.task_id || goal.intent_revision !== section.intent_revision || goal.state !== 'active') fail('RUNNER_OWNERSHIP_INVALID', 'Outline section does not belong to a current goal')
        const previous = this.db.prepare("SELECT s.value payload_json FROM runner_outlines o,json_each(o.payload_json,'$.sections') s WHERE o.task_id=? AND json_extract(s.value,'$.section_id')=? ORDER BY o.outline_revision DESC LIMIT 1").get(outline.task_id, section.section_id) as PayloadRow | undefined
        const old = previous ? validateRunnerContract('runner_outline_section', JSON.parse(previous.payload_json)) : undefined
        if (old && old.request_id !== section.request_id || section.position_revision !== (old ? old.position_revision + Number(old.order_key !== section.order_key) : 1)) fail('RUNNER_OUTLINE_CONFLICT', 'Stable section identity and position predecessor must be retained')
      }
      this.db.prepare('INSERT INTO runner_outlines(task_id,outline_revision,payload_json) VALUES (?,?,?)').run(outline.task_id, outline.outline_revision, json(outline))
      return outline
    }).immediate()
  }

  owner(taskId: string, artifactId: string): ArtifactOwner | null {
    assertRunnerId(taskId, 'task_id'); assertRunnerId(artifactId, 'artifact_id')
    return this.db.prepare('SELECT * FROM runner_artifact_owners WHERE task_id=? AND artifact_id=?').get(taskId, artifactId) as ArtifactOwner | undefined ?? null
  }

  assign(raw: ArtifactAssignment[]): ArtifactOwner[] {
    const assignments = JSON.parse(json(raw)) as ArtifactAssignment[]
    if (!Array.isArray(assignments) || !assignments.length) fail('INVALID_RUNNER_CONTRACT', 'Artifact assignments must be a nonempty array')
    for (const assignment of assignments) {
      if (!assignment || typeof assignment !== 'object') fail('INVALID_RUNNER_CONTRACT', 'Invalid artifact assignment')
      keys(assignment, ['task_id', 'artifact_id', 'section_id', 'work_id', 'plan_revision', 'base_artifact_revision', 'previous_owner'])
      for (const key of ['task_id', 'artifact_id', 'section_id', 'work_id'] as const) assertRunnerId(assignment[key], key)
      revision(assignment.plan_revision); revision(assignment.base_artifact_revision, 0)
      if (assignment.previous_owner !== undefined && assignment.previous_owner !== null) {
        if (typeof assignment.previous_owner !== 'object') fail('INVALID_RUNNER_CONTRACT', 'Invalid previous artifact owner')
        keys(assignment.previous_owner, ['work_id', 'plan_revision'])
        assertRunnerId(assignment.previous_owner.work_id, 'work_id'); revision(assignment.previous_owner.plan_revision)
      }
    }
    if (new Set(assignments.map(item => item.artifact_id)).size !== assignments.length || assignments.some(item => item.task_id !== assignments[0]!.task_id)) fail('RUNNER_ARTIFACT_CONFLICT', 'Artifact assignments require distinct identities within one Task')
    return this.db.transaction(() => assignments.map(assignment => {
      const current = this.db.prepare('SELECT * FROM runner_artifact_owners WHERE artifact_id=?').get(assignment.artifact_id) as ArtifactOwner | undefined
      if (current && current.task_id !== assignment.task_id) fail('RUNNER_OWNERSHIP_INVALID', 'Artifact belongs to another Task')
      // Repeating an installed assignment never resets its accepted pointer.
      if (current && current.work_id === assignment.work_id && current.plan_revision === assignment.plan_revision && current.section_id === assignment.section_id) return current
      if (this.db.prepare('SELECT work_id FROM runner_work_outputs WHERE work_id=? AND plan_revision=? LIMIT 1').get(assignment.work_id, assignment.plan_revision)) fail('RUNNER_OUTPUT_CLOSED', 'A complete work output cannot acquire new or changed fragments')
      this.activeTask(assignment.task_id)
      const previous = assignment.previous_owner
      if (assignment.base_artifact_revision !== (current?.current_revision ?? 0) || (current ? !previous || previous.work_id !== current.work_id || previous.plan_revision !== current.plan_revision : previous != null)) fail('RUNNER_ARTIFACT_CONFLICT', 'Artifact assignment must compare its current owner and accepted baseline')
      const work = this.work.work(assignment.work_id), run = this.work.run(work.run_id)
      if (work.purpose === 'production' && work.update_id) fail('RUNNER_OWNERSHIP_INVALID', 'Chapter producers submit scoped proposals and cannot acquire a whole artifact')
      const section = this.outline(assignment.task_id)?.sections.find(item => item.section_id === assignment.section_id)
      if (work.purpose !== 'production' || run.purpose !== 'production' || work.task_id !== assignment.task_id || run.task_id !== assignment.task_id || work.plan_revision !== assignment.plan_revision || !section || section.request_id !== work.request_id || section.intent_revision !== work.intent_revision || run.request_id !== work.request_id || run.intent_revision !== work.intent_revision || run.runtime_epoch !== this.work.epoch || !run.commit_valid || !['queued', 'running', 'waiting'].includes(run.state) || !['planned', 'queued', 'running', 'waiting', 'succeeded'].includes(work.state)) fail('RUNNER_OWNERSHIP_INVALID', 'Artifact assignment does not match a current production plan and section')
      const goal = this.work.goal(work.request_id)
      if (goal.task_id !== assignment.task_id || goal.state !== 'active' || goal.intent_revision !== work.intent_revision) fail('RUNNER_OWNERSHIP_INVALID', 'Artifact assignment belongs to an obsolete goal')
      this.db.prepare('INSERT INTO runner_artifact_owners(artifact_id,task_id,work_id,plan_revision,section_id,current_revision) VALUES (?,?,?,?,?,?) ON CONFLICT(artifact_id) DO UPDATE SET work_id=excluded.work_id,plan_revision=excluded.plan_revision,section_id=excluded.section_id').run(assignment.artifact_id, assignment.task_id, assignment.work_id, assignment.plan_revision, assignment.section_id, current?.current_revision ?? 0)
      return this.owner(assignment.task_id, assignment.artifact_id)!
    })).immediate()
  }

  candidate(taskId: string, candidateId: string): CandidateRecord | null {
    assertRunnerId(taskId, 'task_id'); assertRunnerId(candidateId, 'candidate_id')
    const row = this.db.prepare('SELECT payload_json,result_json FROM runner_candidates WHERE task_id=? AND candidate_id=?').get(taskId, candidateId) as CandidateRow | undefined
    if (!row) return null
    const candidate = validateRunnerContract('runner_artifact_candidate', JSON.parse(row.payload_json))
    const result = JSON.parse(row.result_json) as ArtifactDecision
    if (result.state === 'accepted') validateRunnerContract('runner_artifact_index', result.index)
    else review(result)
    return { candidate, result }
  }

  artifact(taskId: string, artifactId: string, artifactRevision?: number): ArtifactIndex | null {
    assertRunnerId(taskId, 'task_id'); assertRunnerId(artifactId, 'artifact_id')
    if (artifactRevision !== undefined) revision(artifactRevision)
    const selected = artifactRevision ?? this.owner(taskId, artifactId)?.current_revision
    if (!selected) return null
    const row = this.db.prepare('SELECT payload_json FROM runner_artifacts WHERE task_id=? AND artifact_id=? AND artifact_revision=?').get(taskId, artifactId, selected) as PayloadRow | undefined
    return row ? validateRunnerContract('runner_artifact_index', JSON.parse(row.payload_json)) : null
  }

  installChapterAssembly(input: ChapterAssemblyInstall): ArtifactIndex {
    return new ChapterArtifactState(this.db, this.work, this).install(input)
  }
  checkChapterAssembly(index: ArtifactIndex): ArtifactCandidate | null {
    return new ChapterArtifactState(this.db, this.work, this).check(index)
  }
  resolveChapterReference(index: ArtifactIndex): ArtifactIndex | null {
    return new ChapterArtifactState(this.db, this.work, this).resolve(index)
  }
  chapterMaterialDependencies(index: ArtifactIndex): Extract<WorkDependency, { kind: 'resource' }>[] {
    return new ChapterArtifactState(this.db, this.work, this).materialDependencies(index)
  }

  checkProvenance(taskId: string, provenance: ArtifactCandidate['provenance_ref']): void {
    if (provenance.task_id !== taskId) fail('RUNNER_PROVENANCE_INVALID', 'Candidate provenance must reference an existing source in this Task')
    const exists = provenance.kind === 'record'
      ? this.db.prepare('SELECT id FROM records WHERE task_id=? AND id=?').get(taskId, provenance.id)
      : provenance.kind === 'action'
        ? this.db.prepare('SELECT id FROM actions WHERE task_id=? AND id=?').get(taskId, provenance.id)
        : provenance.kind === 'resource'
          ? this.db.prepare('SELECT r.id FROM task_resources t JOIN resources r ON r.id=t.resource_id WHERE t.task_id=? AND r.id=?').get(taskId, provenance.id)
          : undefined
    if (!exists) fail('RUNNER_PROVENANCE_INVALID', 'Candidate provenance must reference an existing source in this Task')
  }

  private checkCandidate(candidate: ArtifactCandidate): void {
    if (this.db.prepare('SELECT work_id FROM runner_work_outputs WHERE work_id=? AND plan_revision=? LIMIT 1').get(candidate.work_id, candidate.plan_revision)) fail('RUNNER_OUTPUT_CLOSED', 'A complete work output cannot accept another candidate')
    const owner = this.owner(candidate.task_id, candidate.artifact_id)
    if (!owner || owner.work_id !== candidate.work_id || owner.plan_revision !== candidate.plan_revision || owner.section_id !== candidate.section_id) fail('RUNNER_OWNERSHIP_INVALID', 'Candidate no longer owns its logical artifact')
    if (owner.current_revision !== candidate.base_artifact_revision) fail('RUNNER_ARTIFACT_CONFLICT', 'Candidate accepted baseline is no longer current')
    revision(owner.current_revision + 1)
    const qualified = this.work.qualify(candidate.attempt_id)
    const section = this.outline(candidate.task_id)?.sections.find(item => item.section_id === candidate.section_id)
    if (!qualified.goal || !section) fail('RUNNER_OWNERSHIP_INVALID', 'Candidate requires a production goal and installed section')
    const resource = this.db.prepare('SELECT r.id,r.byte_length,r.media_type FROM resources r JOIN task_resources t ON t.resource_id=r.id WHERE t.task_id=? AND r.id=?').get(candidate.task_id, candidate.bundle_resource_id) as { id: string; byte_length: number; media_type: string } | undefined
    if (!resource) fail('RUNNER_RESOURCE_INVALID', 'Candidate resource must be immutable and associated with this Task')
    if (!Number.isSafeInteger(resource.byte_length) || resource.byte_length < 0 || resource.byte_length > defaults.surface.inline_bundle_bytes || resource.media_type !== 'application/json' && !isBundleMediaType(resource.media_type)) fail('INVALID_BUNDLE_SOURCE', 'Candidate bundle must be bounded JSON; resource references do not increase bundle capacity')
    this.checkProvenance(candidate.task_id, candidate.provenance_ref)
    validateArtifactCandidate(candidate, { ...qualified, goal: qualified.goal, section, current_artifact_revision: owner.current_revision, resource_task_id: candidate.task_id })
  }

  decide(raw: ArtifactCandidate, rawReview: CandidateReview): ArtifactDecision {
    const candidate = validateRunnerContract('runner_artifact_candidate', JSON.parse(json(raw)))
    return this.db.transaction(() => {
      const previous = this.db.prepare('SELECT task_id,payload_json,result_json FROM runner_candidates WHERE candidate_id=?').get(candidate.candidate_id) as CandidateRow | undefined
      if (previous) {
        if (previous.task_id !== candidate.task_id || !equivalent(JSON.parse(previous.payload_json), candidate)) fail('RUNNER_CANDIDATE_CONFLICT', 'Candidate identity cannot change its original payload')
        return this.candidate(candidate.task_id, candidate.candidate_id)!.result
      }
      let result: ArtifactDecision
      const requested = review(rawReview)
      try {
        this.checkCandidate(candidate)
        if (requested.state === 'rejected') result = requested
        else {
          const { candidate_id, base_artifact_revision, plan_revision, section_position_revision, dependencies, requirement_ids, unresolved, ...metadata } = candidate
          const index = validateRunnerContract('runner_artifact_index', { ...metadata, artifact_revision: base_artifact_revision + 1, acceptance_state: 'accepted' })
          result = { state: 'accepted', index }
        }
      } catch (error) {
        if (!(error instanceof ContractError)) throw error
        result = { state: 'rejected', code: error.code }
      }
      this.db.prepare('INSERT INTO runner_candidates(candidate_id,task_id,artifact_id,payload_json,result_json) VALUES (?,?,?,?,?)').run(candidate.candidate_id, candidate.task_id, candidate.artifact_id, json(candidate), json(result))
      if (result.state === 'accepted') {
        const index = result.index
        this.db.prepare('INSERT INTO runner_artifacts(task_id,artifact_id,artifact_revision,candidate_id,bundle_resource_id,payload_json) VALUES (?,?,?,?,?,?)').run(index.task_id, index.artifact_id, index.artifact_revision, candidate.candidate_id, index.bundle_resource_id, json(index))
        const installed = this.db.prepare('UPDATE runner_artifact_owners SET current_revision=? WHERE task_id=? AND artifact_id=? AND work_id=? AND plan_revision=? AND section_id=? AND current_revision=?').run(index.artifact_revision, candidate.task_id, candidate.artifact_id, candidate.work_id, candidate.plan_revision, candidate.section_id, candidate.base_artifact_revision)
        if (installed.changes !== 1) fail('RUNNER_ARTIFACT_CONFLICT', 'Candidate lost its current owner or accepted baseline')
        registerRunnerResources(this.db, index.task_id, 'runner_artifact', json([index.artifact_id, index.artifact_revision]), [index.bundle_resource_id, ...(index.provenance_ref.kind === 'resource' ? [index.provenance_ref.id] : []), ...candidate.dependencies.flatMap(input => input.kind === 'resource' ? [input.resource_id] : [])])
      }
      return result
    }).immediate()
  }
}
